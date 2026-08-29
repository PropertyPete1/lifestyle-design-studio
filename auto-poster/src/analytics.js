/**
 * Weekly Performance Feedback Loop
 * 
 * Pulls last 7 days of IG Reel analytics from Metricool, classifies each post's
 * hook style, scores performance, and writes a performance-weights.json that the
 * caption generator uses to bias toward high-performing hook styles.
 * 
 * Hook Styles (5 categories):
 *   question    — "would you believe…?" / "did you know…?"
 *   bold_claim  — "this might be the best…" / "I've never seen…"
 *   wait_tease  — "wait until you see…" / "you won't believe…"
 *   reaction    — "the floor plan made me stop…" / "I was speechless…"
 *   vibe        — "this is what ___ is supposed to feel like"
 * 
 * Scoring formula:
 *   score = (views * 1) + (likes * 5) + (comments * 10) + (shares * 15) + (saved * 8)
 *         + (avgWatchTime / duration * 20)   // retention bonus
 *         - (skipRate * 0.5)                 // penalty for high skip rate
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEIGHTS_PATH = join(__dirname, "..", "performance-weights.json");
const BASE = "https://app.metricool.com/api";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Mc-Auth": process.env.METRICOOL_API_TOKEN,
  };
}

function authParams(blogId = process.env.METRICOOL_BLOG_ID) {
  return `blogId=${blogId}&userId=${process.env.METRICOOL_USER_ID}`;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 19);
}

/**
 * Classify a caption's hook style based on the first line.
 */
export function classifyHookStyle(caption) {
  if (!caption) return "unknown";
  // Strip leading emojis, special chars, and whitespace from the first line
  let firstLine = caption.split("\n")[0]
    .replace(/^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Component}\s\u200d\ufe0f]*/gu, "")
    .toLowerCase().trim();

  // Question style: starts with a question word or contains "?"
  if (/^(would|did|have|can|could|is|are|do|what|how|who|where|why|when)/.test(firstLine) || firstLine.includes("?")) {
    return "question";
  }
  // Wait/tease style
  if (/^(wait|you won't|you need to see|hold on|stop|don't scroll)/.test(firstLine)) {
    return "wait_tease";
  }
  // Bold claim style
  if (/^(this (might|is|could) be|i('ve| have) never|the best|most|hands down|no way|just hit)/.test(firstLine)) {
    return "bold_claim";
  }
  // Reaction style
  if (/^(the .* made me|i (was|am)|my jaw|speechless|stunned|obsessed|in love)/.test(firstLine)) {
    return "reaction";
  }
  // Vibe style — descriptive/atmospheric hooks about the property
  if (/^(this is what|imagine|picture this|the vibe|the energy|the feeling|bright|soaring|mature|stunning|gorgeous|beautiful|spacious|modern|brand new|new construction|luxury)/.test(firstLine)) {
    return "vibe";
  }

  // Fallback: try secondary signals
  if (firstLine.includes("?")) return "question";
  if (firstLine.includes("wait") || firstLine.includes("watch") || firstLine.includes("see this")) return "wait_tease";
  if (firstLine.includes("best") || firstLine.includes("never") || firstLine.includes("just hit") || firstLine.includes("won't last")) return "bold_claim";
  if (firstLine.includes("made me") || firstLine.includes("obsessed") || firstLine.includes("speechless")) return "reaction";
  // If it starts with a property description, it's a vibe hook
  if (/^[a-z]/.test(firstLine) && (firstLine.includes("light") || firstLine.includes("finish") || firstLine.includes("layout") || firstLine.includes("ceiling") || firstLine.includes("home"))) {
    return "vibe";
  }

  return "unknown";
}

/**
 * Score a single reel's performance.
 */
export function scoreReel(reel) {
  const views = reel.views || 0;
  const likes = reel.likes || 0;
  const comments = reel.comments || 0;
  const shares = reel.shares || 0;
  const saved = reel.saved || 0;
  const avgWatch = reel.averageWatchTime || 0;
  const duration = reel.durationSeconds || 1;
  const skipRate = reel.reelsSkipRate || 0;

  const retentionBonus = (avgWatch / duration) * 20;
  const skipPenalty = skipRate * 0.5;

  return (views * 1) + (likes * 5) + (comments * 10) + (shares * 15) + (saved * 8)
    + retentionBonus - skipPenalty;
}

/**
 * Fetch last N days of IG Reel analytics from Metricool.
 */
async function fetchReelAnalytics(days = 7) {
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const url = `${BASE}/v2/analytics/reels/instagram?from=${fmtDate(from)}&to=${fmtDate(to)}&${authParams()}&timezone=America/Chicago`;

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    console.warn(`[Analytics] Fetch failed (${res.status})`);
    return [];
  }
  const json = await res.json();
  return json.data || [];
}

/**
 * Load existing performance weights.
 */
export function loadWeights() {
  if (!existsSync(WEIGHTS_PATH)) {
    return getDefaultWeights();
  }
  try {
    return JSON.parse(readFileSync(WEIGHTS_PATH, "utf-8"));
  } catch {
    return getDefaultWeights();
  }
}

/**
 * Get default equal weights.
 */
function getDefaultWeights() {
  return {
    weights: {
      question: 1.0,
      bold_claim: 1.0,
      wait_tease: 1.0,
      reaction: 1.0,
      vibe: 1.0,
    },
    lastUpdated: null,
    history: [],
  };
}

/**
 * Run the weekly analytics feedback loop.
 * Fetches last 7 days of reels, classifies hooks, scores performance,
 * and updates performance-weights.json.
 */
export async function runWeeklyAnalytics(days = 7) {
  console.log(`[Analytics] Running weekly feedback loop (last ${days} days)...`);

  const reels = await fetchReelAnalytics(days);
  if (reels.length === 0) {
    console.log("[Analytics] No reels found — keeping existing weights");
    return loadWeights();
  }

  console.log(`[Analytics] Analyzing ${reels.length} reels...`);

  // Classify and score each reel
  const classified = reels.map(reel => ({
    url: reel.url,
    hookStyle: classifyHookStyle(reel.content),
    score: scoreReel(reel),
    views: reel.views || 0,
    likes: reel.likes || 0,
    comments: reel.comments || 0,
    shares: reel.shares || 0,
    saved: reel.saved || 0,
    avgWatch: reel.averageWatchTime || 0,
    skipRate: reel.reelsSkipRate || 0,
    firstLine: (reel.content || "").split("\n")[0].slice(0, 80),
  }));

  // Group by hook style and compute average score
  const styleScores = {};
  const styleCounts = {};
  for (const item of classified) {
    if (item.hookStyle === "unknown") continue;
    if (!styleScores[item.hookStyle]) {
      styleScores[item.hookStyle] = 0;
      styleCounts[item.hookStyle] = 0;
    }
    styleScores[item.hookStyle] += item.score;
    styleCounts[item.hookStyle] += 1;
  }

  // Compute average scores
  const avgScores = {};
  for (const style of Object.keys(styleScores)) {
    avgScores[style] = styleScores[style] / styleCounts[style];
  }

  // Normalize to weights (relative to median)
  const allAvgs = Object.values(avgScores);
  if (allAvgs.length === 0) {
    console.log("[Analytics] No classifiable hooks found — keeping existing weights");
    return loadWeights();
  }

  const median = allAvgs.sort((a, b) => a - b)[Math.floor(allAvgs.length / 2)];
  const newWeights = {};
  const ALL_STYLES = ["question", "bold_claim", "wait_tease", "reaction", "vibe"];

  for (const style of ALL_STYLES) {
    if (avgScores[style] !== undefined) {
      // Weight = score relative to median, clamped between 0.3 and 3.0
      const raw = avgScores[style] / (median || 1);
      newWeights[style] = Math.max(0.3, Math.min(3.0, raw));
    } else {
      // No data for this style — keep at 1.0 (neutral)
      newWeights[style] = 1.0;
    }
  }

  // Blend with existing weights (70% new, 30% old) for stability
  const existing = loadWeights();
  const blended = {};
  for (const style of ALL_STYLES) {
    const oldW = existing.weights[style] || 1.0;
    const newW = newWeights[style];
    blended[style] = Math.round((newW * 0.7 + oldW * 0.3) * 100) / 100;
  }

  // Build report
  const report = {
    weights: blended,
    lastUpdated: new Date().toISOString(),
    reelsAnalyzed: reels.length,
    classifiedCount: classified.filter(c => c.hookStyle !== "unknown").length,
    styleBreakdown: {},
    topPerformers: classified.sort((a, b) => b.score - a.score).slice(0, 5).map(r => ({
      url: r.url,
      hookStyle: r.hookStyle,
      score: Math.round(r.score),
      views: r.views,
      firstLine: r.firstLine,
    })),
    history: [...(existing.history || []).slice(-12), {
      date: new Date().toISOString().slice(0, 10),
      weights: { ...blended },
      reelsAnalyzed: reels.length,
    }],
  };

  for (const style of ALL_STYLES) {
    report.styleBreakdown[style] = {
      count: styleCounts[style] || 0,
      avgScore: Math.round(avgScores[style] || 0),
      weight: blended[style],
    };
  }

  // Log summary
  console.log("[Analytics] Hook style performance:");
  for (const style of ALL_STYLES) {
    const sb = report.styleBreakdown[style];
    console.log(`  ${style}: ${sb.count} posts, avg score ${sb.avgScore}, weight → ${sb.weight}`);
  }
  console.log(`[Analytics] Top performer: ${report.topPerformers[0]?.firstLine || "N/A"} (score: ${report.topPerformers[0]?.score || 0})`);

  // Save weights
  writeFileSync(WEIGHTS_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log(`[Analytics] Weights saved to ${WEIGHTS_PATH}`);

  return report;
}

/**
 * Get a weighted random hook style based on performance weights.
 * Higher weight = higher probability of being selected.
 */
export function pickHookStyle(weights = null) {
  const w = weights || loadWeights().weights || getDefaultWeights().weights;
  const styles = Object.keys(w);
  const totalWeight = styles.reduce((sum, s) => sum + w[s], 0);

  let random = Math.random() * totalWeight;
  for (const style of styles) {
    random -= w[style];
    if (random <= 0) return style;
  }
  return styles[styles.length - 1];
}

export { WEIGHTS_PATH };
