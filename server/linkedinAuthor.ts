import { invokeLLM } from "./_core/llm";
import { LINKEDIN_TOPICS } from "../shared/const";
import * as db from "./db";

const LINKEDIN_MODEL = "claude-sonnet-4-6";

/**
 * Pick the topic for a given local date by rotating through LINKEDIN_TOPICS in
 * order, so all six topics get balanced coverage over time. We derive a stable
 * day-index from the date string so the same date always maps to the same topic
 * (idempotent generation).
 */
export function topicForDate(postDate: string): { key: string; label: string; angle: string } {
  // Days since epoch for the given YYYY-MM-DD (UTC midnight is fine; we only
  // need a monotonically increasing integer that changes once per calendar day).
  const [y, m, d] = postDate.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % LINKEDIN_TOPICS.length) + LINKEDIN_TOPICS.length) % LINKEDIN_TOPICS.length;
  return LINKEDIN_TOPICS[idx];
}

/**
 * Strip anything that reads as AI-generated or violates the brief:
 * - em-dashes / en-dashes (—, –) -> replaced with a period + space or comma
 * - surrounding quotes the model sometimes wraps the whole post in
 * - "Here is your post" style preambles
 * - hashtags (LinkedIn recruiting posts here are clean text)
 */
export function sanitizePost(raw: string): string {
  let t = (raw || "").trim();

  // Drop a leading preamble line like "Here's a post:" if present.
  t = t.replace(/^(here'?s|here is|sure|draft|post)[^\n]*:\s*\n+/i, "");

  // Remove wrapping quotes around the entire post.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }

  // Replace em/en dashes. When used as a sentence break (space-dash-space),
  // turn into a period; when gluing words, turn into a comma-free space.
  t = t.replace(/\s*[—–]\s*/g, ". ");
  // Collapse accidental double punctuation from the replacement.
  t = t.replace(/\.\s*\.\s*/g, ". ").replace(/,\s*\./g, ".");

  // Remove hashtags entirely (recruiting posts stay clean).
  t = t
    .split("\n")
    .map(line => line.replace(/(^|\s)#[A-Za-z0-9_]+/g, "").replace(/\s+$/g, ""))
    .join("\n");

  // Normalize 3+ blank lines to a single blank line.
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/** Count words for the < 150 word guardrail. */
export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Build the self-improvement context: the last few posts and how they did, so
 * the model can lean into what worked and avoid repeating hooks/openings. This
 * is what makes the generator "get smarter" over time.
 */
async function buildLearningContext(): Promise<string> {
  const recent = await db.getRecentLinkedinPosts(12);
  if (!recent.length) {
    return "No prior posts yet. This is the first one, so set a strong, authentic baseline.";
  }
  const lines = recent.map(p => {
    const eng = `impressions=${p.impressions} reactions=${p.reactions} comments=${p.comments} shares=${p.shares}`;
    const firstLine = (p.body || "").split("\n")[0].slice(0, 120);
    return `- [${p.postDate}] topic=${p.topic} | ${eng} | hook: "${firstLine}"`;
  });
  const withEngagement = recent.filter(p => p.impressions > 0 || p.reactions > 0 || p.comments > 0);
  let insight = "";
  if (withEngagement.length >= 3) {
    const sorted = [...withEngagement].sort(
      (a, b) => b.reactions + b.comments * 3 + b.shares * 5 - (a.reactions + a.comments * 3 + a.shares * 5)
    );
    const best = sorted[0];
    insight =
      `\nBEST PERFORMER so far (topic=${best.topic}) opened with: "${(best.body || "").split("\n")[0].slice(0, 140)}". ` +
      `Study why that hook drove comments and apply the same energy WITHOUT copying it.`;
  }
  return (
    "RECENT POSTS (newest first) with engagement so you can improve and avoid repeating openings:\n" +
    lines.join("\n") +
    insight
  );
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

export interface GeneratedLinkedinPost {
  topic: string;
  body: string;
}

/**
 * Generate today's LinkedIn recruiting post in Peter's voice for the rotation
 * topic of the given date. Self-improves from recent post engagement. Retries
 * once if the first draft breaks the length rule. Throws if the LLM is
 * unavailable (caller decides how to handle — we never publish empty text).
 */
export async function generateLinkedinPost(postDate: string): Promise<GeneratedLinkedinPost> {
  const topic = topicForDate(postDate);
  const learning = await buildLearningContext();

  const userPrompt =
    `Write today's LinkedIn post.\n\n` +
    `TODAY'S TOPIC: ${topic.label}.\n` +
    `ANGLE: ${topic.angle}\n\n` +
    `${learning}\n\n` +
    `Remember: speak to realtors, recruit them to Lifestyle Design Realty, first person as Peter Allen, ` +
    `under 150 words, no dashes, no hashtags, hook first, comment-driving question last.`;

  async function draft(extra = ""): Promise<string> {
    const res = await invokeLLM({
      model: LINKEDIN_MODEL,
      messages: [
        { role: "system", content: SYSTEM_VOICE + extra },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 600,
    });
    const raw = res.choices?.[0]?.message?.content;
    return sanitizePost(typeof raw === "string" ? raw : "");
  }

  let body = await draft();
  if (!body || wordCount(body) > 150) {
    // One retry with an explicit tightening instruction.
    body =
      (await draft("\n\nYour previous attempt was too long or empty. Keep it well under 150 words.")) || body;
  }
  if (!body) throw new Error("LinkedIn author returned empty content");

  // Final hard trim safety: if still > 150 words, cut to the last full sentence
  // under the limit so we never publish an over-length post.
  if (wordCount(body) > 150) {
    const words = body.split(/\s+/).slice(0, 150).join(" ");
    const lastStop = Math.max(words.lastIndexOf("."), words.lastIndexOf("?"), words.lastIndexOf("!"));
    body = (lastStop > 40 ? words.slice(0, lastStop + 1) : words).trim();
  }

  return { topic: topic.key, body };
}
