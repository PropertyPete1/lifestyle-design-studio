/**
 * LinkedIn Text-Only Posting — Agent Recruiting Content
 * 
 * Generates and publishes text-only LinkedIn posts in Peter Allen's voice.
 * These are RECRUITING posts aimed at realtors/agents, NOT buyers.
 * 
 * 10 rotating topics + lead_overflow override on Tue/Fri.
 * 4 format types rotated daily. Anti-repetition memory via linkedin-history.json.
 * Varied endings: comment question, soft DM CTA, or strong close (no ask).
 * 
 * Posts to all LinkedIn-connected brands via Metricool, staggered 30 min apart.
 * 
 * STAGGER LOGIC: Always 30 minutes between brands regardless of when cron fires.
 * Peter = max(2:00 PM, now + 90s)
 * Steven = max(2:30 PM, Peter + 30min)
 * Lifestyle = max(3:00 PM, Steven + 30min)
 */

import Anthropic from "@anthropic-ai/sdk";
import { stripDashes } from "./sanitize.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE = "https://app.metricool.com/api";
const HISTORY_PATH = join(__dirname, "..", "linkedin-history.json");

function authParams(blogId) {
  return `blogId=${blogId || process.env.METRICOOL_BLOG_ID}&userId=${process.env.METRICOOL_USER_ID}`;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Mc-Auth": process.env.METRICOOL_API_TOKEN,
  };
}

let anthropicClient = null;
function getClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ─── LEAD OVERFLOW FACTS (editable) ─────────────────────────────────────────
// Only these facts may appear in lead_overflow posts. Never invent specifics.
const LEAD_OVERFLOW_FACTS = `More buyer and lease leads than we can work efficiently. Mostly new construction buyer leads in San Antonio and Austin, plus out-of-state relocation buyers. Warm but need vetting and nurture. Most aren't ready today.`;

// Offer-specific CTA for lead_overflow posts (Tue/Fri). Must differ from generic brokerage CTAs.
const LEAD_OVERFLOW_CTA = `If this sounds like something you'd take on, send me a DM.`;

// Market facts that Peter has verified. When EMPTY, market_now posts must avoid
// specific directional claims (prices rising/falling, inventory levels, rate numbers).
// Fill this in to allow specific claims in market_now posts.
const MARKET_FACTS = ``;

// ─── 10 RECRUITING TOPICS ───────────────────────────────────────────────────
const LINKEDIN_TOPICS = [
  {
    key: "why_agents_leave",
    label: "Why agents leave brokerages",
    angle: "Why agents really leave their brokerage and what they are actually looking for (support, leadership, culture, splits, growth). Speak to the agent's frustration and what better looks like.",
  },
  {
    key: "leadership_culture",
    label: "Leadership and culture",
    angle: "Leadership and culture at Lifestyle Design Realty. What it feels like to be led well, invested in, and part of a team that has your back.",
  },
  {
    key: "income_potential",
    label: "Income potential",
    angle: "Income potential and what top agents do differently. Concrete habits, systems, and mindset that separate high earners from everyone else.",
  },
  {
    key: "mindset_motivation",
    label: "Mindset and motivation",
    angle: "Mindset and motivation for realtors. Encouragement for agents grinding through a hard market, staying consistent, and betting on themselves.",
  },
  {
    key: "wish_i_knew",
    label: "What I wish I knew earlier",
    angle: "What I wish I knew earlier in real estate. An honest lesson from Peter's own journey that a newer or stuck agent needs to hear.",
  },
  {
    key: "time_to_level_up",
    label: "Signs it's time to level up",
    angle: "Signs it is time to level up or switch teams. Help an agent recognize they have outgrown where they are and it is time for more.",
  },
  {
    key: "deal_story",
    label: "A deal story from this week",
    angle: "A lesson from a real transaction this week. Keep it generic (no client names or addresses). Focus on the lesson, the pivot, or the thing that almost went wrong. Make agents nod because they have been there.",
  },
  {
    key: "market_now",
    label: "The market right now",
    angle: MARKET_FACTS
      ? `An honest take on the Texas market using ONLY these verified facts: ${MARKET_FACTS}. Focus on what smart agents are doing about it.`
      : "A timeless take on how smart agents navigate uncertain markets. Focus on pricing strategy, seller conversations, buyer psychology, and agent behavior. Do NOT state specific market-direction claims (prices rising/falling, inventory expanding/shrinking, rate levels). You do not have current data. Instead talk about timeless dynamics: pricing right beats chasing the market, how to talk to hesitant sellers, what separates agents who thrive in any market from those who wait for perfect conditions.",
  },
  {
    key: "team_wins",
    label: "Team wins",
    angle: "Celebrating what the team accomplished recently. No names unless provided. Focus on the collective momentum, the culture of winning, and what it means to be part of something growing.",
  },
  {
    key: "unpopular_opinion",
    label: "Unpopular opinion",
    angle: "A contrarian industry take that invites debate. Something most agents believe that Peter disagrees with, backed by experience. Make it specific enough to be interesting, not so extreme it is alienating.",
  },
];

// ─── 4 FORMAT TYPES ─────────────────────────────────────────────────────────
const FORMATS = [
  {
    key: "short_punchy",
    label: "Short punchy (under 60 words)",
    instruction: "Write this post in UNDER 60 WORDS. Extremely concise. Every word earns its place. No filler. Hit hard and stop.",
    maxWords: 60,
  },
  {
    key: "story",
    label: "Story format (~150 words)",
    instruction: "Write this as a mini-narrative (~150 words). Open in the middle of the action or with a specific moment. Build tension or insight. Land the lesson.",
    maxWords: 150,
  },
  {
    key: "list",
    label: "List format (3 numbered points)",
    instruction: "Write this as 3 quick numbered points (no more than 3). Brief intro line, then 3 numbered insights, then a closing line. Keep it tight.",
    maxWords: 150,
  },
  {
    key: "bold_statement",
    label: "Single bold statement + one paragraph",
    instruction: "Open with ONE bold declarative statement on its own line. Then one paragraph (3 to 5 sentences) that unpacks it. That is the whole post.",
    maxWords: 150,
  },
];

// ─── ENDING TYPES ───────────────────────────────────────────────────────────
const ENDING_TYPES = ["question", "dm_cta", "strong_close"];

const DM_CTA_OPTIONS = [
  "And if you're an agent in Texas thinking about your next move, my DMs are open.",
  "If you want to talk about what we're building at Lifestyle Design Realty, send me a DM.",
  "Agents in San Antonio or Austin looking for more leads than you can handle, DM me.",
];

// ─── SCHEDULING LOGIC ───────────────────────────────────────────────────────

/**
 * Get today's date in YYYY-MM-DD format (Chicago timezone).
 */
function getTodayDateStr() {
  const now = new Date();
  const chicagoStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
  const chicago = new Date(chicagoStr);
  const y = chicago.getFullYear();
  const m = String(chicago.getMonth() + 1).padStart(2, "0");
  const d = String(chicago.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Get the day of week for a date string (0=Sun, 1=Mon, ..., 6=Sat).
 */
function getDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * Determine if today is a lead_overflow day (Tuesday=2 or Friday=5).
 */
function isLeadOverflowDay(dateStr) {
  const dow = getDayOfWeek(dateStr);
  return dow === 2 || dow === 5; // Tuesday or Friday
}

/**
 * Pick today's topic. Lead_overflow overrides on Tue/Fri.
 * Other days rotate through the 10 topics.
 */
function topicForDate(dateStr) {
  if (isLeadOverflowDay(dateStr)) {
    return {
      key: "lead_overflow",
      label: "Lead overflow offer",
      angle: "SPECIAL TOPIC. Use ONLY the facts from LEAD_OVERFLOW_FACTS. Rewrite the wording fresh but do not invent any new specifics.",
    };
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % LINKEDIN_TOPICS.length) + LINKEDIN_TOPICS.length) % LINKEDIN_TOPICS.length;
  return LINKEDIN_TOPICS[idx];
}

/**
 * Pick today's format by rotating through the 4 formats based on date.
 * Ensures consecutive days never use the same format.
 */
function formatForDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % FORMATS.length) + FORMATS.length) % FORMATS.length;
  return FORMATS[idx];
}

/**
 * Pick today's ending type by rotating through the 3 types.
 * Lead_overflow days ALWAYS get dm_cta.
 */
function endingForDate(dateStr) {
  if (isLeadOverflowDay(dateStr)) return "dm_cta";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % ENDING_TYPES.length) + ENDING_TYPES.length) % ENDING_TYPES.length;
  return ENDING_TYPES[idx];
}

/**
 * Pick which DM CTA variant to use (rotates by date).
 * Lead overflow days always get the offer-specific CTA.
 */
function dmCtaForDate(dateStr, isOverflow = false) {
  if (isOverflow) return LEAD_OVERFLOW_CTA;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % DM_CTA_OPTIONS.length) + DM_CTA_OPTIONS.length) % DM_CTA_OPTIONS.length;
  return DM_CTA_OPTIONS[idx];
}

// ─── ANTI-REPETITION HISTORY ────────────────────────────────────────────────

/**
 * Load the last 7 posts from linkedin-history.json.
 */
function loadHistory() {
  try {
    if (existsSync(HISTORY_PATH)) {
      const data = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      return Array.isArray(data.posts) ? data.posts.slice(-7) : [];
    }
  } catch (e) {
    console.warn(`[LinkedIn] Could not load history: ${e.message}`);
  }
  return [];
}

/**
 * Save a new post to linkedin-history.json (keeps last 7).
 */
export function saveToHistory(post) {
  let history = { posts: [] };
  try {
    if (existsSync(HISTORY_PATH)) {
      history = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      if (!Array.isArray(history.posts)) history.posts = [];
    }
  } catch (e) {
    history = { posts: [] };
  }
  history.posts.push(post);
  // Keep only last 7
  if (history.posts.length > 7) {
    history.posts = history.posts.slice(-7);
  }
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  console.log(`[LinkedIn] Saved to history (${history.posts.length} entries)`);
}

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────

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
- For "what I wish I knew" topics: draw from Peter's real journey — he started solo, built a team, learned to delegate, learned that splits don't matter if you have no support, learned that culture beats compensation. Pick one angle and write.

Return ONLY the post text. No preamble, no quotes around it, no explanation. Start with the first word of the actual post.`;

// ─── POST GENERATION ────────────────────────────────────────────────────────

/**
 * Convert a Chicago-local Date to a Metricool-compatible datetime string.
 */
function toMetricoolDateTime(chicagoDate) {
  const y = chicagoDate.getFullYear();
  const m = String(chicagoDate.getMonth() + 1).padStart(2, "0");
  const d = String(chicagoDate.getDate()).padStart(2, "0");
  const h = String(chicagoDate.getHours()).padStart(2, "0");
  const min = String(chicagoDate.getMinutes()).padStart(2, "0");
  const s = String(chicagoDate.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

/**
 * Compute staggered publish times for all 3 brands.
 */
function computeStaggeredTimes() {
  const now = new Date();
  const chicagoStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
  const chicago = new Date(chicagoStr);

  const todayBase = new Date(chicago);
  todayBase.setHours(0, 0, 0, 0);

  const idealPeter = new Date(todayBase); idealPeter.setHours(14, 0, 0, 0);
  const idealSteven = new Date(todayBase); idealSteven.setHours(14, 30, 0, 0);
  const idealLifestyle = new Date(todayBase); idealLifestyle.setHours(15, 0, 0, 0);

  const minTime = new Date(chicago.getTime() + 90_000);

  const peterTime = idealPeter > minTime ? idealPeter : new Date(minTime);
  const peterPlus30 = new Date(peterTime.getTime() + 30 * 60_000);
  const stevenTime = idealSteven > peterPlus30 ? idealSteven : peterPlus30;
  const stevenPlus30 = new Date(stevenTime.getTime() + 30 * 60_000);
  const lifestyleTime = idealLifestyle > stevenPlus30 ? idealLifestyle : stevenPlus30;

  return [
    { blogId: 4807109, label: "Peter", publishAt: toMetricoolDateTime(peterTime), time: peterTime },
    { blogId: 6493212, label: "Steven", publishAt: toMetricoolDateTime(stevenTime), time: stevenTime },
    { blogId: 6486275, label: "Lifestyle Design Realty", publishAt: toMetricoolDateTime(lifestyleTime), time: lifestyleTime },
  ];
}

/**
 * Sanitize the AI-generated post: remove dashes, hashtags, preambles, wrapping quotes.
 */
function sanitizePost(raw) {
  let t = (raw || "").trim();

  // Drop AI preambles (thinking out loud, meta-commentary)
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

  // Remove wrapping quotes
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }

  // Replace em/en dashes with periods
  t = stripDashes(t);

  // Remove hashtags
  t = t.split("\n")
    .map(line => line.replace(/(^|\s)#[A-Za-z0-9_]+/g, "").replace(/\s+$/g, ""))
    .join("\n");

  // Normalize blank lines
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  // Strip wrapping quotes from the final line (questions should be plain text)
  const finalLines = t.split("\n");
  const lastIdx = finalLines.length - 1;
  if (lastIdx >= 0) {
    let last = finalLines[lastIdx].trim();
    // Remove wrapping quotes from last line
    if ((last.startsWith('"') && last.endsWith('"')) || (last.startsWith("'") && last.endsWith("'"))) {
      last = last.slice(1, -1).trim();
    }
    // Also handle: "question." → "question?"
    if ((last.startsWith('"') && last.endsWith('."')) || (last.startsWith("'") && last.endsWith(".'"))) {
      last = last.slice(1, -2).trim() + "?";
    }
    finalLines[lastIdx] = last;
  }
  t = finalLines.join("\n");

  return t;
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Build the ending instruction based on ending type.
 */
function buildEndingInstruction(endingType, dateStr) {
  switch (endingType) {
    case "question":
      return "END with ONE thought-provoking question that drives comments from agents. The question MUST end with a question mark (?). No DM ask. Do NOT wrap the question in quotation marks.";
    case "dm_cta":
      return `END with this exact line (copy it verbatim): "${dmCtaForDate(dateStr, isLeadOverflowDay(dateStr))}"`;
    case "strong_close":
      return "END with a strong closing statement. No question, no DM ask, no call to action. Just land it.";
    default:
      return "END with a strong closing line.";
  }
}

/**
 * Build the anti-repetition block from history.
 */
function buildHistoryBlock(history) {
  if (!history.length) return "";
  const posts = history.map((h, i) => `--- Post ${i + 1} (${h.date || "recent"}) ---\n${h.body}`).join("\n\n");
  return `\n\nRECENT POSTS (do NOT open with a similar hook, reuse phrases, or repeat the angle of any of these):\n${posts}`;
}

/**
 * Generate a LinkedIn recruiting post for today's topic.
 * Accepts optional dateOverride for dry-run testing.
 */
export async function generateLinkedinPost(dateOverride = null) {
  const dateStr = dateOverride || getTodayDateStr();
  const topic = topicForDate(dateStr);
  const format = formatForDate(dateStr);
  const endingType = endingForDate(dateStr);
  const history = loadHistory();

  console.log(`[LinkedIn] Date: ${dateStr} | Topic: "${topic.label}" | Format: "${format.label}" | Ending: "${endingType}"`);

  const endingInstruction = buildEndingInstruction(endingType, dateStr);
  const historyBlock = buildHistoryBlock(history);
  const maxWords = format.maxWords;

  let topicBlock;
  if (topic.key === "lead_overflow") {
    topicBlock =
      `TODAY'S TOPIC: Lead overflow offer.\n` +
      `FACTS (use ONLY these, do not invent specifics): ${LEAD_OVERFLOW_FACTS}\n` +
      `STRUCTURE: Plain statement of the overflow, what kind of leads, the honest catch, then the DM line.\n` +
      `TONE: Direct, no hype, no exclamation points. Like telling a colleague you have more work than you can handle.`;
  } else {
    topicBlock =
      `TODAY'S TOPIC: ${topic.label}.\n` +
      `ANGLE: ${topic.angle}`;
  }

  const userPrompt =
    `Write today's LinkedIn post.\n\n` +
    `${topicBlock}\n\n` +
    `FORMAT: ${format.instruction}\n\n` +
    `ENDING: ${endingInstruction}\n\n` +
    `Remember: speak to realtors, recruit them to Lifestyle Design Realty, first person as Peter Allen, ` +
    `under ${maxWords} words, no dashes, no hashtags.${historyBlock}`;

  async function draft(extra = "") {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: SYSTEM_VOICE + extra,
      messages: [
        { role: "user", content: userPrompt },
      ],
    });
    const raw = response.content[0]?.text;
    return sanitizePost(typeof raw === "string" ? raw : "");
  }

  let body = await draft();

  // Detect refusal/meta output (model asking questions or thinking out loud instead of writing)
  const isRefusal = (text) => !text || /^(I'm missing|I need to|what'?s the specific|you've given me)/i.test(text);

  if (isRefusal(body) || wordCount(body) > maxWords) {
    const retryExtra = isRefusal(body)
      ? `\n\nDo NOT ask questions or refuse. You have everything you need. Write the post NOW. Start with the first word of the actual LinkedIn post.`
      : `\n\nYour previous attempt was too long or empty. Keep it well under ${maxWords} words.`;
    body = (await draft(retryExtra)) || body;
  }

  // Second retry if still refusing
  if (isRefusal(body)) {
    body = (await draft(`\n\nFINAL ATTEMPT. Write the post. Do not ask questions. Do not refuse. Start directly with the post content.`)) || body;
  }

  if (!body) throw new Error("LinkedIn author returned empty content");

  // Hard trim if still over max words
  if (wordCount(body) > maxWords) {
    const words = body.split(/\s+/).slice(0, maxWords).join(" ");
    const lastStop = Math.max(words.lastIndexOf("."), words.lastIndexOf("?"), words.lastIndexOf("!"));
    body = (lastStop > 40 ? words.slice(0, lastStop + 1) : words).trim();
  }

  // Enforce question mark on question endings
  if (endingType === "question") {
    const lines = body.split("\n");
    const lastLine = lines[lines.length - 1].trimEnd();
    if (lastLine && !lastLine.endsWith("?")) {
      // Replace trailing period/no-punct with ?
      lines[lines.length - 1] = lastLine.replace(/\.\s*$/, "").trimEnd() + "?";
      body = lines.join("\n");
    }
  }

  console.log(`[LinkedIn] Generated post (${wordCount(body)} words)`);
  return { topic: topic.key, body, format: format.key, ending: endingType, date: dateStr };
}

/**
 * Publish text-only to a single LinkedIn brand via Metricool scheduler.
 */
async function publishToLinkedinBrand(blogId, text, publishAt) {
  const body = {
    text,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "linkedin" }],
    autoPublish: true,
    shortener: false,
    draft: false,
    linkedinData: {
      publishImagesAsPDF: false,
      documentTitle: "",
    },
  };
  const url = `${BASE}/v2/scheduler/posts?${authParams(blogId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: `API error ${res.status}: ${JSON.stringify(raw).slice(0, 200)}` };
  }
  const postId = raw?.id || raw?.data?.id || "unknown";
  return { ok: true, postId };
}

/**
 * Full LinkedIn posting flow:
 * 1. Generate recruiting post in Peter's voice
 * 2. Publish SAME text to all 3 LinkedIn accounts with guaranteed 30-min stagger
 * 3. Save to linkedin-history.json for anti-repetition memory
 * 
 * Returns { ok, topic, body, brands, format, ending }
 */
export async function postToLinkedin(options = {}) {
  const { dryRun = false, dateOverride = null } = options;

  // Generate the post
  const result = await generateLinkedinPost(dateOverride);
  const { topic, body, format, ending, date } = result;

  // Compute staggered times
  const schedule = computeStaggeredTimes();

  if (dryRun) {
    console.log("[LinkedIn] DRY RUN — would post to LinkedIn:");
    console.log(`[LinkedIn] Topic: ${topic} | Format: ${format} | Ending: ${ending}`);
    console.log(`[LinkedIn] Body (${wordCount(body)} words):\n${body}`);
    console.log(`[LinkedIn] Would post to:`);
    for (const brand of schedule) {
      const hh = String(brand.time.getHours()).padStart(2, "0");
      const mm = String(brand.time.getMinutes()).padStart(2, "0");
      console.log(`[LinkedIn]   - ${brand.label} at ${hh}:${mm} CT`);
    }
    return { ok: true, dryRun: true, topic, body, format, ending, date, brands: schedule.map(s => ({ label: s.label, publishAt: s.publishAt })) };
  }

  // Publish to each brand
  const results = [];
  for (const brand of schedule) {
    const hh = String(brand.time.getHours()).padStart(2, "0");
    const mm = String(brand.time.getMinutes()).padStart(2, "0");
    console.log(`[LinkedIn] Publishing to ${brand.label} (blogId: ${brand.blogId}) at ${hh}:${mm} CT...`);
    const pubResult = await publishToLinkedinBrand(brand.blogId, body, brand.publishAt);
    results.push({ ...pubResult, label: brand.label, blogId: brand.blogId, publishAt: brand.publishAt });
    if (pubResult.ok) {
      console.log(`[LinkedIn] ✓ Scheduled for ${brand.label} at ${hh}:${mm} CT (ID: ${pubResult.postId})`);
    } else {
      console.error(`[LinkedIn] ✗ Failed on ${brand.label}: ${pubResult.error}`);
    }
  }

  const anyOk = results.some(r => r.ok);
  if (anyOk) {
    console.log(`[LinkedIn] ✓ LinkedIn recruiting post scheduled (topic: ${topic}, format: ${format})`);
    // Save to history for anti-repetition
    saveToHistory({ topic, body, format, ending, date });
  } else {
    console.error("[LinkedIn] ✗ All LinkedIn brands failed");
  }

  return { ok: anyOk, topic, body, format, ending, brands: results };
}
