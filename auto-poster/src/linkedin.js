/**
 * LinkedIn Text-Only Posting — Agent Recruiting Content
 * 
 * Generates and publishes text-only LinkedIn posts in Peter Allen's voice.
 * These are RECRUITING posts aimed at realtors/agents, NOT buyers.
 * 
 * 6 rotating topics, under 150 words, no hashtags, no emojis-as-bullets,
 * no em-dashes. Hook first, comment-driving question last.
 * 
 * Posts to all LinkedIn-connected brands via Metricool, staggered 30 min apart.
 * 
 * STAGGER LOGIC: Always 30 minutes between brands regardless of when cron fires.
 * Peter = max(2:00 PM, now + 90s)
 * Steven = max(2:30 PM, Peter + 30min)
 * Lifestyle = max(3:00 PM, Steven + 30min)
 */

import Anthropic from "@anthropic-ai/sdk";

const BASE = "https://app.metricool.com/api";

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

/**
 * The 6 recruiting topics that rotate daily.
 */
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
];

/**
 * Pick today's topic by rotating through the 6 topics based on the date.
 */
function topicForDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % LINKEDIN_TOPICS.length) + LINKEDIN_TOPICS.length) % LINKEDIN_TOPICS.length;
  return LINKEDIN_TOPICS[idx];
}

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
 * Always 30 minutes apart, regardless of when the cron fires.
 * 
 * Logic:
 *   Peter  = max(2:00 PM today, now + 90s)
 *   Steven = max(2:30 PM today, Peter + 30min)
 *   Lifestyle = max(3:00 PM today, Steven + 30min)
 * 
 * Returns array of { blogId, label, publishAt (Metricool datetime string) }
 */
function computeStaggeredTimes() {
  const now = new Date();
  const chicagoStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
  const chicago = new Date(chicagoStr);

  // Build today's ideal times (Chicago local)
  const todayBase = new Date(chicago);
  todayBase.setHours(0, 0, 0, 0);

  const idealPeter = new Date(todayBase); idealPeter.setHours(14, 0, 0, 0);
  const idealSteven = new Date(todayBase); idealSteven.setHours(14, 30, 0, 0);
  const idealLifestyle = new Date(todayBase); idealLifestyle.setHours(15, 0, 0, 0);

  // Minimum: 90s from now (Metricool requires future time)
  const minTime = new Date(chicago.getTime() + 90_000);

  // Peter = max(ideal, minTime)
  const peterTime = idealPeter > minTime ? idealPeter : new Date(minTime);

  // Steven = max(ideal, Peter + 30min)
  const peterPlus30 = new Date(peterTime.getTime() + 30 * 60_000);
  const stevenTime = idealSteven > peterPlus30 ? idealSteven : peterPlus30;

  // Lifestyle = max(ideal, Steven + 30min)
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

  // Drop preamble
  t = t.replace(/^(here'?s|here is|sure|draft|post)[^\n]*:\s*\n+/i, "");

  // Remove wrapping quotes
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }

  // Replace em/en dashes with periods
  t = t.replace(/\s*[—–]\s*/g, ". ");
  t = t.replace(/\.\s*\.\s*/g, ". ").replace(/,\s*\./g, ".");

  // Remove hashtags
  t = t.split("\n")
    .map(line => line.replace(/(^|\s)#[A-Za-z0-9_]+/g, "").replace(/\s+$/g, ""))
    .join("\n");

  // Normalize blank lines
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
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
- Under 150 words. Short and punchy.
- Do NOT use em-dashes or en-dashes (— or –). Use short sentences and periods instead. This is important; dashes read as AI.
- Never use generic quotes from famous people. Everything is your own voice and experience.
- Do not use hashtags.

STRUCTURE:
- Line 1: a hook that makes an agent stop scrolling.
- 3 to 5 short lines of value, story, or insight.
- End with ONE line: a thought or question that drives comments.

Return ONLY the post text. No preamble, no quotes around it, no explanation.`;

/**
 * Generate a LinkedIn recruiting post for today's topic.
 */
export async function generateLinkedinPost() {
  const dateStr = getTodayDateStr();
  const topic = topicForDate(dateStr);

  console.log(`[LinkedIn] Topic for ${dateStr}: "${topic.label}"`);

  const userPrompt =
    `Write today's LinkedIn post.\n\n` +
    `TODAY'S TOPIC: ${topic.label}.\n` +
    `ANGLE: ${topic.angle}\n\n` +
    `Remember: speak to realtors, recruit them to Lifestyle Design Realty, first person as Peter Allen, ` +
    `under 150 words, no dashes, no hashtags, hook first, comment-driving question last.`;

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
  if (!body || wordCount(body) > 150) {
    body = (await draft("\n\nYour previous attempt was too long or empty. Keep it well under 150 words.")) || body;
  }

  if (!body) throw new Error("LinkedIn author returned empty content");

  // Hard trim if still over 150 words
  if (wordCount(body) > 150) {
    const words = body.split(/\s+/).slice(0, 150).join(" ");
    const lastStop = Math.max(words.lastIndexOf("."), words.lastIndexOf("?"), words.lastIndexOf("!"));
    body = (lastStop > 40 ? words.slice(0, lastStop + 1) : words).trim();
  }

  console.log(`[LinkedIn] Generated post (${wordCount(body)} words)`);
  return { topic: topic.key, body };
}

/**
 * Publish text-only to a single LinkedIn brand via Metricool scheduler.
 */
async function publishToLinkedinBrand(blogId, text, publishAt) {
  const body = {
    text,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "linkedin" }],
    // No media array -> text-only post
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
 * 2. Publish SAME text to all 3 LinkedIn accounts with guaranteed 30-min stagger:
 *    - Peter → 2:00 PM CT (or now+90s if past 2:00)
 *    - Steven → 2:30 PM CT (or Peter+30min if past 2:30)
 *    - Lifestyle Design Realty → 3:00 PM CT (or Steven+30min if past 3:00)
 * 
 * Returns { ok, topic, body, brands }
 */
export async function postToLinkedin(options = {}) {
  const { dryRun = false } = options;

  // Generate the post
  const { topic, body } = await generateLinkedinPost();

  // Compute staggered times (always 30 min apart)
  const schedule = computeStaggeredTimes();

  if (dryRun) {
    console.log("[LinkedIn] DRY RUN — would post to LinkedIn:");
    console.log(`[LinkedIn] Topic: ${topic}`);
    console.log(`[LinkedIn] Body (${wordCount(body)} words):\n${body}`);
    console.log(`[LinkedIn] Would post to:`);
    for (const brand of schedule) {
      const hh = String(brand.time.getHours()).padStart(2, "0");
      const mm = String(brand.time.getMinutes()).padStart(2, "0");
      console.log(`[LinkedIn]   - ${brand.label} at ${hh}:${mm} CT`);
    }
    return { ok: true, dryRun: true, topic, body, brands: schedule.map(s => ({ label: s.label, publishAt: s.publishAt })) };
  }

  // Publish to each brand
  const results = [];
  for (const brand of schedule) {
    const hh = String(brand.time.getHours()).padStart(2, "0");
    const mm = String(brand.time.getMinutes()).padStart(2, "0");
    console.log(`[LinkedIn] Publishing to ${brand.label} (blogId: ${brand.blogId}) at ${hh}:${mm} CT...`);

    const result = await publishToLinkedinBrand(brand.blogId, body, brand.publishAt);
    results.push({ ...result, label: brand.label, blogId: brand.blogId, publishAt: brand.publishAt });

    if (result.ok) {
      console.log(`[LinkedIn] ✓ Scheduled for ${brand.label} at ${hh}:${mm} CT (ID: ${result.postId})`);
    } else {
      console.error(`[LinkedIn] ✗ Failed on ${brand.label}: ${result.error}`);
    }
  }

  const anyOk = results.some(r => r.ok);
  if (anyOk) {
    console.log(`[LinkedIn] ✓ LinkedIn recruiting post scheduled for all accounts (topic: ${topic})`);
  } else {
    console.error("[LinkedIn] ✗ All LinkedIn brands failed");
  }

  return { ok: anyOk, topic, body, brands: results };
}
