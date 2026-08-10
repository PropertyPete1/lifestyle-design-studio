/**
 * yt-stock.js — the "real world" layer, licensed from Pexels.
 *
 * The three-layer visual system needs one layer that is a photograph of an
 * actual place. Graphics teach and typography asserts, but a video about moving
 * to a suburb with no picture of a suburb in it feels like a lecture. Peter's
 * own long-form footage folder starts empty and fills slowly; stock is what
 * covers the gap without ever reaching back to the reels library.
 *
 * LICENSING IS SETTLED AND WRITTEN DOWN. See longform/STOCK-LICENSING.md. The
 * short version, and the part that changed the design: the Pexels CONTENT
 * licence requires no attribution, but the API GUIDELINES separately require a
 * prominent link to Pexels and photographer credit where possible. Both bind
 * us, because we acquire through the API. So every fetched clip carries a
 * credit record, and the packaging step puts them in the description — not
 * burned into the picture, which is the thing revision 3 exists to remove.
 *
 * NOTHING SHIPS UNSEEN. A stock search for "family moving boxes into house"
 * will eventually return a watermarked clip, a stock-agency slate, a clip with
 * burned-in text in another language, or something that is simply not the
 * subject. Every one of those is worse than no footage, because the fallback is
 * kinetic typography and typography is good. So the vision check FAILS CLOSED:
 * anything it cannot positively confirm is rejected. That is the opposite of
 * quality-check.js's policy for Peter's own reels, and deliberately so — there,
 * rejecting a good clip costs a post; here, accepting a bad one puts an
 * agency watermark in a twelve-minute video that stays up for years.
 */

import { createHash } from "crypto";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

import { assertNoReelsReach } from "./yt-footage-source.js";

const PEXELS_API = "https://api.pexels.com/videos/search";

/** Below this a clip is too short to cut into a segment. */
const MIN_CLIP_SECONDS = 5;

/** 1080p or better, or it will be softer than everything around it. */
const MIN_WIDTH = 1600;

/**
 * Is stock available at all?
 *
 * A missing key is an ordinary configuration state, not an error: the pipeline
 * runs without stock and every FOOTAGE intent falls through to typography. It
 * is logged once, loudly, because a build that quietly stopped using stock and
 * a build that never had it configured look identical in the output.
 */
export function stockEnabled() {
  return Boolean(process.env.PEXELS_API_KEY);
}

/**
 * Search Pexels for one query.
 *
 * Returns [] on ANY failure — no key, network down, rate limited, malformed
 * payload, HTML error page where JSON was promised. The caller's response to
 * every one of those is the same (try the next keyword, then fall back), so
 * distinguishing them in the return type would only invite a caller to treat
 * one as fatal. They are distinguished in the log, which is where a human
 * debugging a build actually looks.
 */
export async function searchPexels(query, { perPage = 8, orientation = "landscape", fetchImpl = fetch } = {}) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];

  const params = new URLSearchParams({
    query: String(query || "").slice(0, 120),
    per_page: String(perPage),
    orientation,
    size: "medium",
  });

  let data;
  try {
    const res = await fetchImpl(`${PEXELS_API}?${params}`, { headers: { Authorization: key } });
    if (res.status === 429) {
      console.warn("[Stock] Pexels rate limit reached — falling back for the rest of this build");
      return [];
    }
    if (!res.ok) {
      console.warn(`[Stock] Pexels returned ${res.status} for "${query}"`);
      return [];
    }
    data = await res.json();
  } catch (err) {
    console.warn(`[Stock] Pexels request failed for "${query}": ${err.message}`);
    return [];
  }

  // The API contract is a shape, not a promise. A garbage payload that happens
  // to be valid JSON must not throw its way out of here.
  if (!data || !Array.isArray(data.videos)) {
    console.warn(`[Stock] Pexels returned an unexpected payload for "${query}"`);
    return [];
  }

  return data.videos.map(normaliseVideo).filter(Boolean);
}

/**
 * Flatten one API video into what the picker needs.
 *
 * Defensive about every field. Pexels is a well-behaved API, but this is the
 * boundary between our types and someone else's, and a missing `video_files`
 * should cost one candidate rather than the build.
 */
function normaliseVideo(v) {
  if (!v || typeof v !== "object") return null;
  const files = Array.isArray(v.video_files) ? v.video_files : [];
  // Largest file that is still a sane delivery size — the 4K masters are
  // hundreds of megabytes and get downscaled to 1080p immediately anyway.
  const usable = files
    .filter((f) => f && typeof f.link === "string" && Number(f.width) >= MIN_WIDTH && Number(f.width) <= 2600)
    .sort((a, b) => Number(b.width) - Number(a.width));
  const file = usable[0] || files.find((f) => f && typeof f.link === "string");
  if (!file) return null;

  return {
    id: String(v.id ?? ""),
    url: String(file.link),
    pageUrl: String(v.url || ""),
    width: Number(file.width) || 0,
    height: Number(file.height) || 0,
    durationSeconds: Number(v.duration) || 0,
    photographer: String(v.user?.name || "").trim() || "Pexels contributor",
    photographerUrl: String(v.user?.url || ""),
  };
}

/**
 * Rank candidates. Longer and larger wins, with a floor on both.
 *
 * No cleverness about content — that is the vision check's job, and it runs on
 * pixels rather than on metadata. Pexels' own relevance ordering is the only
 * signal here worth trusting, so ties break toward it by keeping the sort
 * stable.
 */
export function rankCandidates(videos, { minSeconds = MIN_CLIP_SECONDS } = {}) {
  return videos
    .filter((v) => v.durationSeconds >= minSeconds && v.width >= MIN_WIDTH)
    .map((v, i) => ({ ...v, rank: i }))
    .sort((a, b) => b.width - a.width || a.rank - b.rank);
}

/** Stable identity for a clip, for the cache and the no-repeat rules. */
export function stockContentHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

/**
 * The credit line the description will carry.
 *
 * Both obligations in one string: the photographer, and Pexels itself with a
 * link. Built here rather than in the packaging step so the wording lives next
 * to the code that knows where the clip came from.
 */
export function creditFor(video) {
  return {
    photographer: video.photographer,
    photographerUrl: video.photographerUrl || null,
    pageUrl: video.pageUrl || null,
    line: `Video by ${video.photographer} on Pexels${video.pageUrl ? ` — ${video.pageUrl}` : ""}`,
  };
}

/**
 * Brand-grade a stock clip so it sits in the same world as the cards.
 *
 * Stock is shot to look like anything; the channel looks like one thing. A raw
 * Pexels drone shot cut against a black-and-gold card reads as two videos
 * spliced together, and that mismatch is exactly what makes stock look like
 * stock.
 *
 * The grade is deliberately restrained — a slight desaturation, a warm lift
 * toward the brand gold, a gentle contrast curve and a vignette. Enough to
 * belong, not so much that it announces a filter. It also satisfies the licence
 * term against redistributing unaltered copies, though that is a side effect
 * rather than the reason.
 */
export function gradeArgs(input, output, { seconds, dim = { w: 1920, h: 1080 }, fps = 30, strength = 1 } = {}) {
  const s = Math.max(0, Math.min(1, strength));
  const graph = [
    `scale=${dim.w}:${dim.h}:force_original_aspect_ratio=increase`,
    `crop=${dim.w}:${dim.h}`,
    // Warm the highlights toward gold, cool the shadows very slightly. The
    // numbers are small on purpose: skin tone is the first thing a heavy grade
    // ruins, and half these clips have people in them.
    `colorbalance=rs=${(0.06 * s).toFixed(3)}:gs=${(0.02 * s).toFixed(3)}:bs=${(-0.05 * s).toFixed(3)}:rm=${(0.04 * s).toFixed(3)}:bm=${(-0.03 * s).toFixed(3)}`,
    `eq=saturation=${(1 - 0.18 * s).toFixed(3)}:contrast=${(1 + 0.08 * s).toFixed(3)}:brightness=${(-0.02 * s).toFixed(3)}`,
    `vignette=angle=PI/5`,
    `fps=${fps}`,
    "format=yuv420p",
    "setsar=1",
  ].join(",");

  return [
    "-y", "-i", input,
    "-t", String(seconds),
    "-vf", graph,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-an",
    output,
  ];
}

/**
 * Ask a vision model whether this clip is actually what was requested.
 *
 * FAILS CLOSED. An unparseable answer, a thrown request, a missing key — all
 * reject. quality-check.js fails open for Peter's own reels because there the
 * footage is known-good and a false rejection costs a post. Here the footage is
 * from the open internet and a false ACCEPTANCE costs a watermark on the
 * channel's first long-form video, so the asymmetry runs the other way.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export async function visionCheckClip(framePaths, { subject, client, model = "claude-haiku-4-5-20251001" } = {}) {
  if (!client) return { ok: false, reason: "no vision client available" };
  if (!framePaths || framePaths.length === 0) return { ok: false, reason: "no frames could be extracted" };

  let images;
  try {
    images = framePaths.map((fp) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: readFileSync(fp).toString("base64") },
    }));
  } catch (err) {
    return { ok: false, reason: `could not read extracted frames: ${err.message}` };
  }

  const prompt = `These frames are from a stock video clip being considered as B-roll for an educational real-estate video. The clip was requested to show: "${subject}".

Reject the clip if ANY of these is true:
1. There is a watermark, logo, or stock-agency mark anywhere in the frame.
2. There is burned-in text, a caption, a title card, or on-screen writing of any kind.
3. The subject is not plausibly "${subject}".
4. The frames are black, corrupted, heavily blurred, or a solid colour.
5. A person appears to be endorsing or presenting a product or service (a person speaking to camera, holding a sign, or gesturing at branding). Scenery and candid activity are fine.

Be strict. If you are unsure, reject.

Respond with ONLY valid JSON: {"ok": true/false, "reason": "brief explanation"}`;

  let text;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: [...images, { type: "text", text: prompt }] }],
    });
    text = response?.content?.[0]?.text?.trim();
  } catch (err) {
    return { ok: false, reason: `vision check failed: ${err.message}` };
  }

  try {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, reason: `vision check returned no JSON: "${String(text).slice(0, 80)}"` };
    const parsed = JSON.parse(match[0]);
    // An explicit true is the ONLY pass. A truthy string, a missing field or a
    // number all reject, because a model that answered in an unexpected shape
    // is a model whose answer we did not actually read.
    if (parsed.ok === true) return { ok: true, reason: String(parsed.reason || "matches the request") };
    return { ok: false, reason: String(parsed.reason || "rejected by vision check") };
  } catch (err) {
    return { ok: false, reason: `vision check response was not parseable: ${err.message}` };
  }
}

/**
 * The Drive cache.
 *
 * Repeat builds of the same script must not re-fetch: it burns the 200/hour
 * rate limit, it is slow, and — the real reason — Pexels' relevance ordering
 * can change between calls, so a rebuild could silently swap a clip Peter has
 * already approved. Caching by the SEARCH RESULT rather than by the query makes
 * the second build byte-identical to the first, which is what the cold-run
 * determinism check depends on.
 */
export function cacheKey(video) {
  return `pexels-${video.id}.mp4`;
}

export async function readCache(video, { dir, driveGet = null }) {
  const local = join(dir, cacheKey(video));
  if (existsSync(local)) return { path: local, source: "local-cache" };
  if (driveGet) {
    try {
      const buf = await driveGet(cacheKey(video));
      if (buf && buf.length > 10240) {
        writeFileSync(local, buf);
        return { path: local, source: "drive-cache" };
      }
    } catch (err) {
      console.warn(`[Stock] Drive cache read failed for ${cacheKey(video)}: ${err.message}`);
    }
  }
  return null;
}

/**
 * Fetch, cache, grade and verify one stock clip for a FOOTAGE intent.
 *
 * Walks the keywords in order and the candidates within each, taking the first
 * clip that survives the vision check. Returns null when nothing does — which
 * is a normal outcome, not an error, and the caller answers it with typography.
 *
 * @returns {{ path, credit, contentHash, video, query, attempts } | null}
 */
export async function fetchStockClip({
  keywords = [],
  seconds,
  subject = null,
  dir,
  index = 0,
  orientation = "landscape",
  usedHashes = new Set(),
  client = null,
  ffmpeg,
  fetchImpl = fetch,
  driveGet = null,
  drivePut = null,
  maxCandidates = 3,
}) {
  const attempts = [];
  if (!stockEnabled()) {
    attempts.push({ stage: "config", reason: "PEXELS_API_KEY is not set" });
    return { clip: null, attempts };
  }

  for (const keyword of keywords.filter(Boolean)) {
    const results = await searchPexels(keyword, { orientation, fetchImpl });
    if (results.length === 0) {
      attempts.push({ keyword, stage: "search", reason: "no results" });
      continue;
    }

    const ranked = rankCandidates(results).slice(0, maxCandidates);
    if (ranked.length === 0) {
      attempts.push({ keyword, stage: "rank", reason: `${results.length} result(s), none long or large enough` });
      continue;
    }

    for (const video of ranked) {
      const raw = join(dir, cacheKey(video));
      let cached = await readCache(video, { dir, driveGet });

      if (!cached) {
        let buf;
        try {
          const res = await fetchImpl(video.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buf = Buffer.from(await res.arrayBuffer());
        } catch (err) {
          attempts.push({ keyword, videoId: video.id, stage: "download", reason: err.message });
          continue;
        }
        if (buf.length < 10240) {
          attempts.push({ keyword, videoId: video.id, stage: "download", reason: `file too small (${buf.length} bytes)` });
          continue;
        }
        writeFileSync(raw, buf);
        if (drivePut) {
          try {
            await drivePut(cacheKey(video), buf);
          } catch (err) {
            // A cache write that fails costs a refetch next build, nothing more.
            console.warn(`[Stock] could not write ${cacheKey(video)} to the Drive cache: ${err.message}`);
          }
        }
        cached = { path: raw, source: "fetched" };
      }

      const bytes = readFileSync(cached.path);
      const contentHash = stockContentHash(bytes);
      // The same no-repeat rule every other clip obeys. A stock shot reused
      // three videos running is exactly as noticeable as a reel reused three
      // videos running.
      if (usedHashes.has(contentHash)) {
        attempts.push({ keyword, videoId: video.id, stage: "no-repeat", reason: "already used recently" });
        continue;
      }

      // Grade FIRST, then check the graded frames — the vision check should see
      // what will actually be on screen, not the source. A watermark survives
      // grading; so does a caption.
      const graded = join(dir, `stock-${String(index).padStart(3, "0")}-${video.id}.mp4`);
      try {
        ffmpeg(gradeArgs(cached.path, graded, { seconds }));
      } catch (err) {
        attempts.push({ keyword, videoId: video.id, stage: "grade", reason: err.message });
        continue;
      }

      const frames = extractFrames(graded, { seconds, dir, index, ffmpeg });
      const verdict = await visionCheckClip(frames, { subject: subject || keyword, client });
      if (!verdict.ok) {
        attempts.push({ keyword, videoId: video.id, stage: "vision", reason: verdict.reason });
        continue;
      }

      return {
        clip: {
          path: graded,
          seconds,
          contentHash,
          credit: creditFor(video),
          video,
          query: keyword,
          cacheSource: cached.source,
          visionReason: verdict.reason,
        },
        attempts,
      };
    }
  }

  return { clip: null, attempts };
}

/** Two frames, a quarter and two thirds in. Enough to catch a watermark. */
function extractFrames(clipPath, { seconds, dir, index, ffmpeg }) {
  const out = [];
  for (const [i, frac] of [0.25, 0.65].entries()) {
    const p = join(dir, `stockframe-${String(index).padStart(3, "0")}-${i}.jpg`);
    try {
      ffmpeg(["-y", "-ss", String((seconds * frac).toFixed(2)), "-i", clipPath, "-frames:v", "1", "-q:v", "3", p]);
      if (existsSync(p)) out.push(p);
    } catch {
      // A frame that will not extract is itself evidence, and the caller's
      // fail-closed check turns an empty list into a rejection.
    }
  }
  return out;
}

/**
 * The credits block for the YouTube description.
 *
 * Returns "" when no stock was used, so a video built entirely from graphics
 * and typography does not carry a dangling "Footage credits" header with
 * nothing under it.
 */
export function creditsBlock(credits = []) {
  const unique = [];
  const seen = new Set();
  for (const c of credits) {
    if (!c || seen.has(c.line)) continue;
    seen.add(c.line);
    unique.push(c);
  }
  if (unique.length === 0) return "";
  return ["Stock footage via Pexels (https://www.pexels.com)", ...unique.map((c) => `• ${c.line}`)].join("\n");
}

export { assertNoReelsReach };
