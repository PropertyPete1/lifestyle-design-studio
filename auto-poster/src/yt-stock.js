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
import { STOCK_GRADE_SLACK_SECONDS } from "./yt-config.js";

const PEXELS_API = "https://api.pexels.com/videos/search";

/**
 * Thrown when Pexels' quota is exhausted and waiting it out inside the run is
 * not possible. Typed, so the layers above can tell "the well is dry, come
 * back at :10 past" from every other way a search can fail — the distinction
 * run 31766707987 could not make.
 */
export class StockQuotaError extends Error {
  constructor(message, retryAfterSeconds = null) {
    super(message);
    this.name = "StockQuotaError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The longest a run will sleep waiting for the Pexels quota window to reset.
 *
 * Fifteen minutes: Pexels resets hourly, a build spends about that long on its
 * other work anyway, and one bounded wait is far cheaper than a failed run.
 * Waits longer than this fail immediately instead — "quota exhausted, retry
 * after X" is an honest answer and silent degradation into beat-covered takes
 * is the dishonest one this policy replaces.
 */
const QUOTA_MAX_WAIT_SECONDS = Number.parseFloat(process.env.YT_STOCK_QUOTA_MAX_WAIT || "900");

/**
 * One wait per run. A second 429 after a full quota-window wait means the
 * window is being consumed faster than this build can use it (another consumer
 * on the same key); more sleeping cannot fix that and the run should say so.
 */
const quota = { waits: 0, hits429: 0 };

/** For the build report: how often the quota bit during this run. */
export function stockQuotaStats() {
  return { ...quota };
}

/**
 * The counters assume one build per process. The test process runs many
 * scenarios; each resets between them so "one wait per run" means one wait per
 * SCENARIO rather than one wait per suite.
 */
export function resetStockQuotaState() {
  quota.waits = 0;
  quota.hits429 = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Seconds until the quota window resets, best effort from Pexels' headers.
 * `X-Ratelimit-Reset` is a unix timestamp; `Retry-After` is seconds. Null when
 * the response says neither, which callers treat as "longer than we wait".
 */
export function quotaResetSeconds(res, now = Date.now()) {
  const reset = Number.parseInt(res?.headers?.get?.("X-Ratelimit-Reset") || "", 10);
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - now / 1000));
  const after = Number.parseInt(res?.headers?.get?.("Retry-After") || "", 10);
  if (Number.isFinite(after) && after >= 0) return after;
  return null;
}

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
 * Returns [] on ordinary failure — no key, network down, malformed payload,
 * HTML error page where JSON was promised. The caller's response to those is
 * the same (try the next keyword, then fall back), so distinguishing them in
 * the return type would only invite a caller to treat one as fatal.
 *
 * A 429 IS NOT ORDINARY AND IS NOT ALLOWED TO LOOK ORDINARY ANYMORE. The old
 * behaviour — warn once, return [] — made an exhausted quota byte-identical to
 * "Pexels has no such footage", and run 31766707987 turned that into takes
 * covered end to end by the wordless beat, then a failed build with no way to
 * tell quota from content. Now: one bounded in-run wait for the window to
 * reset (Pexels resets hourly; the wait is capped by YT_STOCK_QUOTA_MAX_WAIT),
 * and past that a typed StockQuotaError that names when to come back. The
 * build fails fast and honestly instead of degrading quietly.
 */
export async function searchPexels(query, { perPage = 8, orientation = "landscape", fetchImpl = fetch, maxWaitSeconds = QUOTA_MAX_WAIT_SECONDS, sleepImpl = sleep } = {}) {
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
    let res = await fetchImpl(`${PEXELS_API}?${params}`, { headers: { Authorization: key } });
    if (res.status === 429) {
      quota.hits429++;
      const resetIn = quotaResetSeconds(res);
      const canWait = quota.waits === 0 && resetIn !== null && resetIn <= maxWaitSeconds;
      if (!canWait) {
        const when = resetIn !== null ? `${resetIn}s` : "up to an hour (Pexels sent no reset header)";
        throw new StockQuotaError(
          `Pexels quota exhausted${quota.waits > 0 ? " again after an in-run wait" : ""} — retry after ${when}`,
          resetIn
        );
      }
      quota.waits++;
      console.log(`[Stock] Pexels quota exhausted — waiting ${resetIn + 2}s in-run for the window to reset (once per build)`);
      await sleepImpl((resetIn + 2) * 1000);
      res = await fetchImpl(`${PEXELS_API}?${params}`, { headers: { Authorization: key } });
      if (res.status === 429) {
        quota.hits429++;
        const again = quotaResetSeconds(res);
        throw new StockQuotaError(
          `Pexels quota exhausted again immediately after a full window wait — another consumer is on this key; retry after ${again ?? "?"}s`,
          again
        );
      }
    }
    if (!res.ok) {
      console.warn(`[Stock] Pexels returned ${res.status} for "${query}"`);
      return [];
    }
    data = await res.json();
  } catch (err) {
    if (err instanceof StockQuotaError) throw err;
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

  // CRITERION 3 ASKS WHAT THE FOOTAGE DEPICTS, NOT WHAT THE NARRATION CLAIMS.
  //
  // It used to be handed the spoken sentence with the names removed, so it was
  // asked whether a clip was plausibly "just south and west of that hospital
  // cluster" — and it answered, correctly, that it could not tell. A probe of
  // sixteen windows produced 48 rejections and zero search misses: there was
  // footage every time and the question had no possible yes.
  //
  // The clip is GENERIC B-ROLL standing in for a description. It is never
  // evidence about a specific place — that is why proper nouns are stripped
  // before any of this — so requiring it to establish a location, a distance or
  // a direction is requiring the one thing it must never be taken to prove.
  //
  // Criteria 1, 2, 4 and 5 are unchanged and stay strict. Those are what stop a
  // watermark, a title card or somebody presenting a product reaching the
  // video, and the probe showed them working exactly as intended.
  const prompt = `These frames are from a stock video clip being considered as generic B-roll for an educational real-estate video. It should depict: "${subject}".

Reject the clip if ANY of these is true:
1. There is a watermark, logo, or stock-agency mark anywhere in the frame.
2. There is burned-in text, a caption, a title card, or on-screen writing of any kind.
3. The footage does not plausibly depict "${subject}".
4. The frames are black, corrupted, heavily blurred, or a solid colour.
5. A person appears to be endorsing or presenting a product or service (a person speaking to camera, holding a sign, or gesturing at branding). Scenery and candid activity are fine.

On criterion 3, judge ONLY what is visible. This clip is illustrative stock, not evidence about a real location: do NOT require it to establish any specific place, distance, direction, neighbourhood, or claim made elsewhere in the video. "A hospital campus" is satisfied by any hospital campus. Ask only whether a viewer would accept these frames as a shot of "${subject}".

Be strict on 1, 2, 4 and 5 — if you are unsure, reject.

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
      //
      // GRADED PAST THE WINDOW, ON PURPOSE. The bridge that retires a beat
      // extends a neighbouring scene, and a clip cut to exactly its window can
      // only be extended by replaying itself — the restart jump card 11 wore
      // in the middle of its scenes. The slack seconds are the extension's
      // real footage; a clip shorter than window+slack simply grades whole.
      const gradedSeconds = Math.min(
        video.durationSeconds || seconds,
        seconds + STOCK_GRADE_SLACK_SECONDS
      );
      const graded = join(dir, `stock-${String(index).padStart(3, "0")}-${video.id}.mp4`);
      try {
        ffmpeg(gradeArgs(cached.path, graded, { seconds: gradedSeconds }));
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
          // What the file actually holds, so the bridge knows how much unseen
          // footage an extension can draw on before it would loop.
          gradedSeconds,
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
